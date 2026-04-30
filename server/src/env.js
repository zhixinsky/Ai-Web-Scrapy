import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  let raw = fs.readFileSync(envPath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  const parsed = dotenv.parse(raw);
  for (const [k, v] of Object.entries(parsed)) {
    process.env[k] = v;
  }
} else {
  dotenv.config({ path: envPath });
}

const pt = String(process.env.PIXIAN_TEST || '')
  .trim()
  .toLowerCase();
if (pt === '1' || pt === 'true' || pt === 'yes') {
  console.log('[env] PIXIAN_TEST 已生效：Pixian 请求将附带 test=true（开发测试，结果含水印）');
}
