
export interface RawStarknetEvent {
  block_hash: string;
  block_number: number;
  transaction_hash: string;
  from_address: string;
  keys: string[];
  data: string[];
  event_index: number;
}

export interface GetEventsResponse {
  events: RawStarknetEvent[];
  continuation_token?: string;
}
