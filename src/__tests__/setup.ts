// Env variables for tests — real API keys not needed for unit/mock tests
process.env.TMDB_API_KEY = 'test_tmdb_key';
process.env.OMDB_API_KEY = 'test_omdb_key';
process.env.SERPER_API_KEY = 'test_serper_key';
process.env.ANTHROPIC_API_KEY = 'test_claude_key';
process.env.GEMINI_API_KEY = 'test_gemini_key';
process.env.BOT_TOKEN = 'test_bot_token';
process.env.DB_PATH = ':memory:';
