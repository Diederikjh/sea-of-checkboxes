import type { ServerMessage } from "@sea/protocol";

export interface TileBatchFanoutArgs<TClient> {
  message: Extract<ServerMessage, { t: "cellUpBatch" }>;
  tileToClients: Map<string, Set<string>>;
  clients: Map<string, TClient>;
  sendServerMessage(client: TClient, message: Extract<ServerMessage, { t: "cellUpBatch" }>): void;
}

export function fanoutTileBatchToSubscribers<TClient>({
  message,
  tileToClients,
  clients,
  sendServerMessage,
}: TileBatchFanoutArgs<TClient>): void {
  const subscribers = tileToClients.get(message.tile);
  if (!subscribers || subscribers.size === 0) {
    return;
  }

  for (const uid of subscribers) {
    const client = clients.get(uid);
    if (!client) {
      continue;
    }
    sendServerMessage(client, message);
  }
}
