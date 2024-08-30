import { Router } from 'express'
import { certificateRoute } from "./certificateRoute";

export const router = Router();
router.use("/certificate", certificateRoute);


