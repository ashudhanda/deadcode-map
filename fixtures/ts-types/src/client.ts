export interface Client {
  get(url: string): Promise<unknown>;
}

export type Response<T> = {
  data: T;
  status: number;
};

export type NeverUsed = {
  unused: boolean;
};

export type UnusedImport = {
  x: string;
};
