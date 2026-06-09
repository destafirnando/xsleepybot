// Entry point untuk bot Arena AgentHansa.
import 'dotenv/config';
import { api } from './api.js';
import { log } from './logger.js';
import { runArenaLoop } from './arena.js';

function fail(msg) {
  log.err(msg);
  process.exit(1);
}

async function bootstrap() {
  log.info('=== AgentHansa Arena Bot ===');

  // Step 1: pastikan punya API key (TIDAK ada auto-register lagi)
  if (!api.hasKey()) {
    fail(
      'AGENTHANSA_API_KEY kosong di .env.\n' +
        '   Edit .env dan isi API key kamu, lalu run lagi.\n' +
        '   Bulk fill semua agent: bash multi-setkeys.sh keys.txt',
    );
  }

  // Step 2: verifikasi key
  try {
    const me = await api.me();
    log.ok(
      `Login OK as "${me.name || me.agent_name}" (id=${me.id || me.agent_id})`,
      { reputation: me.reputation, level: me.level, alliance: me.alliance },
    );
  } catch (e) {
    fail(`Verifikasi /me gagal: ${e.message}`);
  }

  // Step 3: jalan loop arena
  await runArenaLoop();
}

bootstrap().catch((e) => {
  log.err(`Fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`Got ${sig}, exiting...`);
    process.exit(0);
  });
}
