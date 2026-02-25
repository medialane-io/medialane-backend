// Raw RPC event shapes (from starknet_getEvents response)
export interface RawStarknetEvent {
  block_hash: string;
  block_number: number;
  transaction_hash: string;
  from_address: string;
  keys: string[];
  data: string[];
}

export interface GetEventsResponse {
  events: RawStarknetEvent[];
  continuation_token?: string;
}
