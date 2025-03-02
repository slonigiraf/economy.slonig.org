import request from 'supertest';
import dotenv from 'dotenv';
dotenv.config();
const BASE_URL = process.env.TEST_URL as string;

describe('Prices API Tests', () => {
    test('Get right prices', async () => {
        // Request
        const response = await request(BASE_URL).get(`/prices/`);
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.diploma).toBe('dd');
        expect(response.body.reimbursement).toBe('dd');
    });
});