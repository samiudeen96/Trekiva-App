import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleClaim } from "../lib/public-api.server";

// POST /api/public/welcome-claim  (also reachable via the app proxy: /apps/welcome-popup/welcome-claim)
export const action = ({ request }: ActionFunctionArgs) => handleClaim(request);
export const loader = ({ request }: LoaderFunctionArgs) => handleClaim(request); // OPTIONS / wrong method
