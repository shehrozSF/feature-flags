// A project's webhook (ADR 0039): where flag-change events go, and the secret they
// are signed with. Setting it always makes a new secret, shown only in that answer.
import { toFieldErrors, WebhookInputSchema } from '@ff/contracts';
import { randomBase62 } from '../keys';
import { NotFoundError, ValidationError } from './errors';
import type { Repository, WebhookInfo } from './ports';
import { parseUrl, type ParsedUrl } from '../web';

/** Hosts that mean "this machine": plain http to them is allowed on the Node server. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Why a URL can't be a webhook, or null if it can. https only: events carry flag
 * configuration and are signed with the project's secret, so they shouldn't travel
 * in the clear. Credentials in the URL would sit in the database and in logs.
 */
export function webhookUrlProblem(raw: string, allowLocalHttp: boolean): string | null {
  let url: ParsedUrl;
  try {
    url = parseUrl(raw);
  } catch {
    return 'url is not a valid URL';
  }
  const localHttp = allowLocalHttp && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) return 'url must use https';
  if (url.username || url.password) return 'url must not contain a username or password';
  return null;
}

export class WebhookService {
  constructor(
    private readonly repo: Repository,
    /** The Node dev server allows http://localhost, for a local n8n. Never the Worker. */
    private readonly options: { allowLocalHttp?: boolean } = {},
  ) {}

  /** Creates or replaces the webhook, always with a new secret, returned only here. */
  async set(projectId: string, input: unknown): Promise<WebhookInfo & { secret: string }> {
    const parsed = WebhookInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(toFieldErrors(parsed.error));
    const problem = webhookUrlProblem(parsed.data.url, this.options.allowLocalHttp ?? false);
    if (problem) throw new ValidationError([{ path: 'url', message: problem }]);

    const secret = `whsec_${randomBase62(43)}`;
    const info = await this.repo.setWebhook(projectId, parsed.data.url, secret);
    return { ...info, secret };
  }

  async get(projectId: string): Promise<WebhookInfo> {
    const webhook = await this.repo.getWebhook(projectId);
    if (!webhook) throw new NotFoundError('this project has no webhook');
    const { secret: _secret, ...info } = webhook;
    return info;
  }

  async delete(projectId: string): Promise<void> {
    if (!(await this.repo.deleteWebhook(projectId))) {
      throw new NotFoundError('this project has no webhook');
    }
  }
}
