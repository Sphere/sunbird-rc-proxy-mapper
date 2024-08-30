import { logger } from "../utils/logger";
import { Client } from 'pg';
export const client = new Client({
    user: process.env.POSTGRES_USER,
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DATABASE,
    password: process.env.POSTGRES_PASSWORD,
    port: 5432,
});
export const connectDB = async () => {
    try {
        await client.connect();
        logger.info('Database connected successfully');
    } catch (error) {
        logger.error('Database connection error:', error);
        throw new Error('Database connection error');
    }
};
connectDB()
module.exports = { client }