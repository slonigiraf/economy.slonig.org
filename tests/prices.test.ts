import request from 'supertest';
import dotenv from 'dotenv';
import { getDiplomaPrice, getAirdropAmount, getWarrantyAmount, DAYS_VALID } from '../src/utils';
dotenv.config();
const BASE_URL = process.env.TEST_URL as string;

describe('Prices API Tests', () => {
    test('Get right prices', async () => {
        const countryOfLocalHost = 'LO';
        const response = await request(BASE_URL).get(`/prices/`);
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.airdrop).toBe(getAirdropAmount(countryOfLocalHost).toString());
        expect(response.body.diploma).toBe(getDiplomaPrice(countryOfLocalHost).toString());
        expect(response.body.warranty).toBe(getWarrantyAmount(countryOfLocalHost).toString());
        expect(response.body.daysValid).toBe(DAYS_VALID);
    });
});