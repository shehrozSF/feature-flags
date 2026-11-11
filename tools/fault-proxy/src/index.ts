// Test helpers for the SDK resilience tests (spec §10): a fake API that speaks the
// real protocol, and a proxy that breaks the network between it and an SDK.
export { startFakeApi, type FakeApi } from './fake-api';
export { CORRUPT_BODY, startFaultProxy, type Fault, type FaultProxy } from './proxy';
export { FakeSocket, fakeSockets } from './fake-socket';
