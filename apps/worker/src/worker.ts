import {
  type Env,
  type ExecutionContextLike,
} from "./doCommon";
import { ConnectionShardDO } from "./connectionShardDO";
import { TileOwnerDO } from "./tileOwnerDO";
import { handleWorkerFetch } from "./workerFetch";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContextLike): Promise<Response> {
    return handleWorkerFetch(request, env);
  },
};

export {
  ConnectionShardDO,
  TileOwnerDO,
};
