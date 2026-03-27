
import { identifyFromText } from './src/services/movieService';
import 'dotenv/config';

async function test() {
  console.log('--- STARTING TEST ---');
  const query = "kichkina robot yerda yolg'iz o'zi qolib ketgan, hamma odamlar koinotga ketgan";
  const result = await identifyFromText(query);
  console.log('RESULT:', JSON.stringify(result, null, 2));
  console.log('--- TEST FINISHED ---');
}

test().catch(console.error);
