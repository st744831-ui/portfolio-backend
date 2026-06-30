// src/scripts/init-admin.js — generate a password hash for ADMIN_PASSWORD_HASH.
// Usage: node src/scripts/init-admin.js "your-strong-password"
import { hashPassword } from '../password.js';

const pw = process.argv[2];
if (!pw) {
  console.error('Usage: node src/scripts/init-admin.js "your-password"');
  process.exit(1);
}
console.log('\nAdd this to your .env:\n');
console.log('ADMIN_PASSWORD_HASH=' + hashPassword(pw));
console.log('\n(then remove the plain ADMIN_PASSWORD line)\n');
