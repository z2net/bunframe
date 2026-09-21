//! The frontend: the typed view shim over the injected bootstrap.
import { defineRPC } from "@z2net/bunframe/view";
import type { AppRpc } from "../src/rpc.ts";

const rpc = defineRPC<AppRpc>({ maxRequestTime: 2_000 });

const output = document.getElementById("app") as HTMLElement | null;

const boot = async (): Promise<void> => {
  // The bridge binds asynchronously - retry until the backend
  // answers, then greet for real.
  for (;;) {
    try {
      const { message } = await rpc.request.greet({ name: "bunframe" });
      if (output !== null) {
        output.textContent = message;
      }
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
};

void boot();
