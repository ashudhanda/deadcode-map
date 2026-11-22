import { CatsService } from './cats.service.js';

export class CatsModule {
  constructor(private readonly service: CatsService) {}

  getService() {
    return this.service;
  }
}
