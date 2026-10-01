import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleEvent } from "../lib/public-api.server";

export const action = ({ request }: ActionFunctionArgs) => handleEvent(request);
export const loader = ({ request }: LoaderFunctionArgs) => handleEvent(request);
