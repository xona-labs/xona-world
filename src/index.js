import { config } from './config.js';
import { createApp } from './api.js';
import { startLoop } from './engine.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`[xona-world] listening on ${config.publicUrl}`);
  console.log(`[xona-world] cycle every ${config.cycleSeconds}s, LLM ${config.openrouter.apiKey ? 'ready' : 'DISABLED (set OPENROUTER_API_KEY)'}`);
  startLoop();
});
