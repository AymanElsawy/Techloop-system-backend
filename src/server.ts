import { env } from './config/env.js';
import { connectDatabase } from './config/database.js';
import { app } from './app.js';

await connectDatabase();

app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT}`);
});
