import { env } from './config/env.js';
import { connectDatabase } from './config/database.js';
import { app } from './app.js';
import { scheduleBackups } from './modules/settings/backup.js';
import { scheduleExpiryAlerts } from './modules/inventory/expiry-alerts.js';

await connectDatabase();
scheduleBackups();
scheduleExpiryAlerts();

app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT}`);
});
