import { MemoryHistoryStore } from './memory.js';
import { historyStoreContract } from './store.contract.js';

historyStoreContract('memory', async () => ({ store: new MemoryHistoryStore(), teardown: async () => {} }));
