import express from 'express';

import calculateRouter from './routes/calculate.js';

const app = express();
const port = 3000;

app.use(express.json());

app.use('/calculate', calculateRouter);

app.get('/', (req, res) => {
  res.send('Optivolt API is running.');
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
