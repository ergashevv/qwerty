// Env variables for tests — real API keys not needed for unit/mock tests
process.env.TMDB_API_KEY = 'test_tmdb_key';
process.env.OMDB_API_KEY = 'test_omdb_key';
process.env.BOT_TOKEN = 'test_bot_token';

// dotenv/config avval yuklangan bo‘lishi mumkin — Azure bo‘lsa LLM yo‘li mock’larni chetlab o‘tadi
delete process.env.AZURE_OPENAI_ENDPOINT;
delete process.env.AZURE_OPENAI_API_KEY;
delete process.env.AZURE_OPENAI_DEPLOYMENT;
delete process.env.AZURE_OPENAI_DEPLOYMENT_VISION;

// Unset DATABASE_URL so describeDb = describe.skip in unit tests.
// DB tests require a live Postgres connection — they run via npm run test:integration.
delete process.env.DATABASE_URL;
