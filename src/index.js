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

  // Step 1: pastikan punya API key
  if (!api.hasKey()) {
    const name = process.env.AGENT_NAME?.trim();
    const desc = process.env.AGENT_DESCRIPTION?.trim() || 'Arena bot';
    if (!name) {
      fail(
        'Belum ada AGENTHANSA_API_KEY DAN AGENT_NAME kosong di .env.\n' +
          '   Edit .env minimal isi AGENT_NAME, lalu run lagi.',
      );
    }
    log.info(`Register agent baru: name="${name}"`);
    try {
      const res = await api.register(name, desc);
      const key = res.api_key || res.key;
      if (!key) fail(`Register sukses tapi tidak dapat api_key: ${JSON.stringify(res)}`);
      api.setKey(key);
      log.ok(`Agent terdaftar! id=${res.id || res.agent_id || 'n/a'}`);
    } catch (e) {
      fail(`Register gagal: ${e.message}`);
    }
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
