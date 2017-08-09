export interface Table {
  'delete'(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  read(key: string): Promise<Object>;
  write(key: string, value: Object): Promise<void>;
}

export interface Database {
  'delete'(table: string): Promise<boolean>;
  list(): Promise<string[]>;
  open(table: string): Promise<Table>;
}

export class NotFound {
  constructor(public table: string, public key: string) {}
}