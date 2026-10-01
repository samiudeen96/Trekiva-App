import type { LoaderFunctionArgs } from "react-router";
import { handleConfig } from "../lib/public-api.server";

// GET /api/public/welcome-config?shop=...  (app proxy: /apps/welcome-popup/welcome-config)
export const loader = ({ request }: LoaderFunctionArgs) => handleConfig(request);
