import type { Client, Response } from './client';
import { UnusedImport } from './client';
import type { User, CustomResponse } from './types';
import { request } from './request';

declare const client: Client;

type LocalDead = string;

export function runCheck(): Promise<Response<User>> {
  const reply: Response<User> = { data: { name: 'a' }, status: 200 };
  const custom = request<User, CustomResponse>();
  const byType: typeof client = client;
  void custom;
  void byType;
  return Promise.resolve(reply);
}
