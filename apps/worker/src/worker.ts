import {
  type Env,
  type ExecutionContextLike,
} from "./doCommon";
import { AccountLinkDO } from "./accountLinkDO";
import { ConnectionShardDO } from "./connectionShardDO";
import { CursorHubDO } from "./cursorHubDO";
import { TileOwnerDO } from "./tileOwnerDO";
import { handleWorkerFetch } from "./workerFetch";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContextLike): Promise<Response> {
    return handleWorkerFetch(request, env);
  },
};

export {
  AccountLinkDO,
  ConnectionShardDO,
  CursorHubDO,
  TileOwnerDO,
};
