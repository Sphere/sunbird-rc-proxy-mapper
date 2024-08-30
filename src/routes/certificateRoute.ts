import { Router } from 'express'
import { getUserCertificateDetails, generateUserCertificatesFromRc } from '../controllers/certificateController';
export const certificateRoute = Router();
certificateRoute.get("/getUserCertificateDetails", getUserCertificateDetails)
certificateRoute.post("/generateUserCertificatesFromRc", generateUserCertificatesFromRc)
