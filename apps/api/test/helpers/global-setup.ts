// Starts one throwaway Postgres in Docker for the whole test run and shares its
// URL with every test file (Vitest `provide` / `inject`).
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  project.provide('pgUrl', container.getConnectionUri());
}

export async function teardown() {
  await container?.stop();
}
