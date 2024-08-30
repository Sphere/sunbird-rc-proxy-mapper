require('dotenv').config();
import express from "express";
import { router } from "./routes/index";
import { logger } from "./utils/logger";
import bodyParser from 'body-parser';

const app = express();
app.use((req, _res, next) => {
    logger.info(`Requested Route: ${req.method} ${req.url}`);
    next();
});
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/v1", router);
app.listen(process.env.APPLICATION_PORT, () => {
    logger.info(`Sever listening on port ${process.env.APPLICATION_PORT}`);
});
