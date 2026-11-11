// The Worker's main module. Only the handler is exported: workerd treats every
// named export here as an entrypoint and won't start on anything else (issues #66).
import { createWorker } from './app';

export default createWorker();
