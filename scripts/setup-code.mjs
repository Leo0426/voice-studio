import { createAccessStore } from '../web/backend/access.mjs';
import { accountDatabase, localSetupCode } from '../web/backend/setup-code.mjs';

const file = accountDatabase();
const store = createAccessStore({ filename: file });
try {
  if (store.status().needsSetup) console.log('Voice Studio 首次管理员设置码\n' + localSetupCode(file));
  else console.log('这台设备已创建管理员。请使用已有账号登录。');
} finally { store.close(); }
