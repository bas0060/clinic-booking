import { httpServerHandler } from "cloudflare:node";
import app from "./app.js";

// Cloudflare Workers entry point. The port is only a label that links the app to the handler.
app.listen(3000);
export default httpServerHandler({ port: 3000 });
