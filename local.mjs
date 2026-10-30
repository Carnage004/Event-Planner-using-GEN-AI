import { createServer } from 'node:http';
import handler from './server-handler.mjs';

const port = Number(process.env.PORT || 3000);
createServer(handler).listen(port, '127.0.0.1', () => {
  console.log(`Jashn is ready at http://127.0.0.1:${port}`);
});
