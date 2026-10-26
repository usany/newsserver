import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module.js';

describe('AppController (e2e)', () => {
	let app: INestApplication;
	let baseUrl: string;

	beforeAll(async () => {
		const moduleFixture: TestingModule = await Test.createTestingModule({
			imports: [AppModule],
		}).compile();

		app = moduleFixture.createNestApplication();
		await app.init();

		// Listen on an ephemeral port so fetch can hit a real HTTP server.
		const server = await app.listen(0);
		const address = server.address();
		baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
	});

	afterAll(async () => {
		await app.close();
	});

	it('/ (GET)', async () => {
		const res = await fetch(`${baseUrl}/`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('Welcome!');
	});
});
