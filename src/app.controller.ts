import { Controller, Get } from '@nestjs/common';
import type { AppService } from './app.service.js';

@Controller()
export class AppController {
	constructor(private readonly appService: AppService) {}

	@Get()
	getWelcome(): string {
		return this.appService.getWelcome();
	}
}
