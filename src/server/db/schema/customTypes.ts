import { customType } from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return 'bytea'; },
  toDriver(value: Buffer) { return value; },
  fromDriver(value: Buffer) { return Buffer.from(value); },
});
