import { Request, Response } from "express"
import { logger } from "../utils/logger";
import { client } from "../utils/postgresConnection";
import axios from 'axios';
import sharp from 'sharp';
import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import { Buffer } from 'buffer';
const PDFDocument = require("pdfkit");
const SVGtoPDF = require("svg-to-pdfkit");
import stream from 'stream';

const s3 = new AWS.S3({
    accessKeyId: process.env.ACCESS_KEY_ID,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});
const bucketName = process.env.AWS_BUCKET_NAME || "sunbird-rc-proxy-certificates";

const uploadToS3 = async (fileName: string, fileBuffer: any, bucketName: string, contentType: string) => {
    try {
        logger.info({ fileName, bucketName, contentType }, "Uploading to S3");
        const params = {
            Bucket: bucketName,
            Key: fileName,
            Body: fileBuffer,
            ContentType: contentType,
        };
        const result = await s3.upload(params).promise();
        logger.info({ location: result.Location, fileName }, "S3 upload successful");
        return result;
    } catch (error: any) {
        logger.error({ err: error?.message, fileName, bucketName }, "S3 upload failed");
    }
};

export const getUserCertificateDetails = async (req: Request, res: Response) => {
    const { userId } = req.query
    logger.info({ userId }, "getUserCertificateDetails: request received");
    try {
        if (!userId) {
            logger.warn("getUserCertificateDetails: userId is missing in query params");
            return res.status(400).json({ message: "Bad Request", reason: "userId is required" });
        }
        const selectQuery = 'SELECT * FROM rc_proxy_user_mapping WHERE userId = $1';
        logger.info({ userId }, "getUserCertificateDetails: querying DB");
        const selectResult = await client.query(selectQuery, [userId]);
        logger.info({ userId, rowCount: selectResult.rowCount }, "getUserCertificateDetails: DB query result");

        if (selectResult.rowCount === 0) {
            logger.warn({ userId }, "getUserCertificateDetails: no certificate records found for user");
        }

        const formattedResult = selectResult.rows.map((row) => {
            return {
                "userId": row.userid,
                "rcUserCertificateId": row.rcusercertificateid,
                "rcCertificateTemplateId": row.rccertificatetemplateid,
                "userName": row.username,
                "meta": row.meta,
                "createdAt": row.createdat,
                "updatedAt": row.updatedat,
                "certificateDownloadUrl": row.certificatedownloadurl,
                "certificateName": row.certificatename,
                "thumbnail": row.thumbnail
            }
        })
        logger.info({ userId, count: formattedResult.length }, "getUserCertificateDetails: returning certificates");
        res.status(200).json({
            message: "SUCCESS",
            data: formattedResult
        })
    } catch (error: any) {
        logger.error({ err: error?.message, userId }, "getUserCertificateDetails: DB query failed");
        res.status(500).json({
            "message": "User not found",
            "reason": "Something went wrong while retrieving user details"
        })
    }
};

const generateKeycloakAdminToken = async () => {
    const keycloakHost = process.env.SUNBIRD_RC_KEYCLOAK_HOST;
    logger.info({ keycloakHost }, "generateKeycloakAdminToken: requesting token");
    try {
        const response = await axios.post(
            `${keycloakHost}/auth/realms/sunbird-rc/protocol/openid-connect/token`,
            new URLSearchParams({
                client_id: 'admin-api',
                grant_type: 'client_credentials',
                username: `${process.env.SUNBIRD_RC_KEYCLOAK_USERNAME}`,
                client_secret: `${process.env.SUNBIRD_RC_CLIENT_SECRET}`,
                password: `${process.env.SUNBIRD_RC_KEYCLOAK_PASSWORD}`
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        logger.info({ keycloakHost, tokenType: response.data.token_type, expiresIn: response.data.expires_in }, "generateKeycloakAdminToken: token obtained");
        return response.data.access_token
    } catch (error: any) {
        logger.error({
            keycloakHost,
            httpStatus: error?.response?.status,
            err: error?.response?.data || error?.message
        }, "generateKeycloakAdminToken: failed");
        return false
    }
};

const generateCertificateFromRC = async (templateId: String, rcCertificateGenerationBody: any, userToken: String) => {
    const rcHost = process.env.SUNBIRD_RC_CORE_HOST;
    const url = `${rcHost}/api/v1/${templateId}`;
    logger.info({ url, templateId, body: rcCertificateGenerationBody }, "generateCertificateFromRC: calling RC API");
    try {
        const generateCertificateResponseFromRc = await axios.post(
            url,
            rcCertificateGenerationBody,
            {
                headers: {
                    'Accept': 'application/json',
                    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
                    'Connection': 'keep-alive',
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${userToken}`
                },
            }
        );
        const osid = generateCertificateResponseFromRc.data.result[`${templateId}`].osid;
        logger.info({ templateId, osid, rcResponse: generateCertificateResponseFromRc.data }, "generateCertificateFromRC: certificate created in RC");
        return osid;
    } catch (error: any) {
        logger.error({
            url,
            templateId,
            httpStatus: error?.response?.status,
            err: error?.response?.data || error?.message
        }, "generateCertificateFromRC: failed");
        return false
    }
}

const getCertificateDetailsFromRC = async (certificateOsid: String, userToken: String, templateId: String) => {
    const rcHost = process.env.SUNBIRD_RC_CORE_HOST;
    const url = `${rcHost}/api/v1/${templateId}/${certificateOsid}`;
    logger.info({ url, templateId, certificateOsid }, "getCertificateDetailsFromRC: fetching certificate SVG");
    try {
        const certificateDataFromRc = await axios.get(url, {
            headers: {
                'Accept': 'image/svg+xml',
                'template-key': 'html',
                'Authorization': `Bearer ${userToken}`,
            },
        });
        const data = certificateDataFromRc.data;
        const dataType = typeof data;
        const dataPreview = dataType === 'string' ? data.substring(0, 200) : JSON.stringify(data).substring(0, 200);
        logger.info({ templateId, certificateOsid, dataType, dataPreview, contentLength: dataType === 'string' ? data.length : null }, "getCertificateDetailsFromRC: response received");
        return data;
    } catch (error: any) {
        logger.error({
            url,
            templateId,
            certificateOsid,
            httpStatus: error?.response?.status,
            err: error?.response?.data || error?.message
        }, "getCertificateDetailsFromRC: failed");
        return false
    }
}

const uploadCertificateToS3ForMyCertificates = async (certificateDetails: any, templateId: String, userId: String, certificateCreationTime: Number, eventId: String, rcCertificateGenerationBody: any) => {
    logger.info({ userId, templateId }, "uploadCertificateToS3ForMyCertificates: started");
    try {
        if (typeof certificateDetails !== 'string') {
            logger.error({ userId, templateId, dataType: typeof certificateDetails }, "uploadCertificateToS3ForMyCertificates: certificate details is not a string");
            return false
        }

        certificateDetails = certificateDetails.replace(/&nbsp;/g, '&#160;');
        const svgStartIndex = certificateDetails.indexOf('<svg');
        const svgEndIndex = certificateDetails.indexOf('</svg>') + 6;
        logger.info({ userId, templateId, svgStartIndex, svgEndIndex, totalLength: certificateDetails.length }, "uploadCertificateToS3ForMyCertificates: SVG extraction indices");

        if (svgStartIndex === -1 || svgEndIndex <= 6) {
            logger.error({ userId, templateId, svgStartIndex, svgEndIndex, dataPreview: certificateDetails.substring(0, 300) }, "uploadCertificateToS3ForMyCertificates: SVG tags not found");
            return false
        }

        certificateDetails = certificateDetails.substring(svgStartIndex, svgEndIndex);
        logger.info({ userId, templateId, svgLength: certificateDetails.length }, "uploadCertificateToS3ForMyCertificates: SVG extracted");

        const certificateBuffer = await sharp(Buffer.from(certificateDetails))
            .png({ compressionLevel: 0 })
            .toBuffer();
        logger.info({ userId, templateId, certificateBufferSize: certificateBuffer.length }, "uploadCertificateToS3ForMyCertificates: certificate PNG buffer created");

        const thumbnailBuffer = await sharp(Buffer.from(certificateDetails))
            .png({ quality: 100 })
            .resize({ width: 200, height: 200 })
            .toBuffer();
        logger.info({ userId, templateId, thumbnailBufferSize: thumbnailBuffer.length }, "uploadCertificateToS3ForMyCertificates: thumbnail PNG buffer created");

        const certKey = `${templateId}/${userId}/${certificateCreationTime}-certificate.png`;
        const thumbKey = `${templateId}/${userId}/${certificateCreationTime}-thumbnail.png`;
        await uploadToS3(certKey, certificateBuffer, bucketName, "image/png");
        await uploadToS3(thumbKey, thumbnailBuffer, bucketName, "image/png");
        logger.info({ userId, templateId, certKey, thumbKey }, "uploadCertificateToS3ForMyCertificates: both files uploaded");
        return true
    } catch (error: any) {
        logger.error({ err: error?.message, userId, templateId }, "uploadCertificateToS3ForMyCertificates: failed");
        return false
    }
}

const uploadCertificateToS3ForMdo = async (certificateDetails: any, templateId: String, userId: String, certificateCreationTime: Number, eventId: String, rcCertificateGenerationBody: any) => {
    logger.info({ userId, templateId, eventId }, "uploadCertificateToS3ForMdo: started");
    try {
        const cleanedSvgData = certificateDetails
            .replace(/<\/?head[^>]*>/g, '')
            .replace(/<\/?style[^>]*>/g, '')
            .replace(/<\/?body[^>]*>/g, '');
        logger.info({ userId, templateId, cleanedSvgLength: cleanedSvgData.length }, "uploadCertificateToS3ForMdo: SVG cleaned");

        const pdfDoc = new PDFDocument({ size: "A4", layout: "landscape" });
        const passThroughStream = new stream.PassThrough();
        pdfDoc.pipe(passThroughStream);
        SVGtoPDF(pdfDoc, cleanedSvgData, 0, 0);
        pdfDoc.end();

        const pdfKey = `mdo-rc-certificates/${eventId}/${rcCertificateGenerationBody.name}-${rcCertificateGenerationBody.date}-certificate.pdf`;
        logger.info({ userId, templateId, eventId, pdfKey }, "uploadCertificateToS3ForMdo: uploading PDF to S3");
        await uploadToS3(pdfKey, passThroughStream, bucketName, "application/pdf");
        logger.info({ userId, templateId, pdfKey }, "uploadCertificateToS3ForMdo: PDF uploaded");
        return true
    } catch (error: any) {
        logger.error({ err: error?.message, userId, templateId, eventId }, "uploadCertificateToS3ForMdo: failed");
        return false
    }
}

const updateUserCertificateDetails = async (userId: String, templateId: String, userName: String, certificateOsid: String, certificateCreationTime: Number, certificateName: String) => {
    logger.info({ userId, templateId, certificateOsid, certificateName }, "updateUserCertificateDetails: inserting DB record");
    try {
        const uuid: string = uuidv4();
        const certificateUrl = `https://${bucketName}.s3.ap-south-1.amazonaws.com/${templateId}/${userId}/${certificateCreationTime}-certificate.png`
        const thumbnailUrl = `https://${bucketName}.s3.ap-south-1.amazonaws.com/${templateId}/${userId}/${certificateCreationTime}-thumbnail.png`
        logger.info({ userId, templateId, certificateUrl, thumbnailUrl }, "updateUserCertificateDetails: certificate URLs generated");

        const insertQuery = `
        INSERT INTO rc_proxy_user_mapping (
            uuid_id,
            userid,
            rcusercertificateid,
            rccertificatetemplateid,
            username,
            meta,
            certificatedownloadurl,
            certificatename,
            thumbnail
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;
        const insertValues = [
            uuid, userId, certificateOsid, templateId, userName, {}, certificateUrl, certificateName, thumbnailUrl
        ]
        await client.query(insertQuery, insertValues);
        logger.info({ userId, templateId, uuid, certificateOsid }, "updateUserCertificateDetails: DB record inserted successfully");
        return { certificateUrl, thumbnailUrl }
    } catch (error: any) {
        logger.error({ err: error?.message, userId, templateId, certificateOsid }, "updateUserCertificateDetails: DB insert failed");
        return false
    }
}

export const generateUserCertificatesFromRc = async (req: Request, res: Response) => {
    const { rcCertificateGenerationBody, templateId, userId, userName, certificateName, eventId } = req.body
    const startTime = Date.now();

    logger.info({ userId, templateId, eventId, userName, certificateName, rcCertificateGenerationBody }, "generateUserCertificatesFromRc: request received");

    if (!templateId || !userId || !userName || !eventId) {
        logger.error({ templateId, userId, userName, eventId }, "generateUserCertificatesFromRc: missing required fields in request body");
        return res.status(400).json({ message: "Bad Request", reason: "templateId, userId, userName and eventId are required" });
    }

    try {
        const certificateCreationTime = Date.now()

        // Step 1: Keycloak token
        const keycloakAdminToken = await generateKeycloakAdminToken()
        if (!keycloakAdminToken) {
            logger.error({ userId, templateId, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: Step 1 FAILED — Keycloak token");
            return res.status(500).json({ "message": "Failed", "reason": "Something went wrong while retrieving admin token" })
        }
        logger.info({ userId, templateId, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: Step 1 DONE — Keycloak token obtained");

        // Step 2: Create certificate in RC
        const certificateOsid = await generateCertificateFromRC(templateId, rcCertificateGenerationBody, keycloakAdminToken)
        if (!certificateOsid) {
            logger.error({ userId, templateId, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: Step 2 FAILED — RC certificate creation");
            return res.status(500).json({ "message": "Failed", "reason": "Something went wrong while generating user certificates" })
        }
        logger.info({ userId, templateId, certificateOsid, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: Step 2 DONE — certificate created in RC");

        // Step 3: Fetch SVG from RC
        let certificateDetailsFromRc = await getCertificateDetailsFromRC(certificateOsid, keycloakAdminToken, templateId)
        if (!certificateDetailsFromRc) {
            logger.error({ userId, templateId, certificateOsid, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: Step 3 FAILED — fetch SVG from RC");
            return res.status(500).json({ "message": "Failed", "reason": "Something went wrong while retrieving user certificates from RC" })
        }
        logger.info({ userId, templateId, certificateOsid, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: Step 3 DONE — certificate SVG fetched");

        // Step 4: Upload PNG to S3
        const uploadCertificateStatusforMyCertificates = await uploadCertificateToS3ForMyCertificates(certificateDetailsFromRc, templateId, userId, certificateCreationTime, eventId, rcCertificateGenerationBody)
        if (!uploadCertificateStatusforMyCertificates) {
            logger.error({ userId, templateId, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: Step 4 FAILED — PNG upload to S3");
            return res.status(500).json({ "message": "Failed", "reason": "Something went wrong while uploading user certificates to S3" })
        }
        logger.info({ userId, templateId, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: Step 4 DONE — PNG uploaded to S3");

        // Step 5: Upload PDF to S3 for MDO
        const uploadCertificateStatusForMdo = await uploadCertificateToS3ForMdo(certificateDetailsFromRc, templateId, userId, certificateCreationTime, eventId, rcCertificateGenerationBody)
        if (!uploadCertificateStatusForMdo) {
            logger.error({ userId, templateId, eventId, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: Step 5 FAILED — PDF upload to S3 for MDO");
            return res.status(500).json({ "message": "Failed", "reason": "Something went wrong while uploading user certificates to S3 for MDO portal" })
        }
        logger.info({ userId, templateId, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: Step 5 DONE — PDF uploaded to S3 for MDO");

        // Step 6: Save to DB
        const updateUserCertificateDetailStatus = await updateUserCertificateDetails(userId, templateId, userName, certificateOsid, certificateCreationTime, certificateName)
        if (!updateUserCertificateDetailStatus) {
            logger.error({ userId, templateId, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: Step 6 FAILED — DB insert");
            return res.status(500).json({ "message": "Failed", "reason": "Something went wrong while updating user certificates details" })
        }
        logger.info({
            userId, templateId, certificateOsid,
            certificateUrl: updateUserCertificateDetailStatus.certificateUrl,
            thumbnailUrl: updateUserCertificateDetailStatus.thumbnailUrl,
            totalMs: Date.now() - startTime
        }, "generateUserCertificatesFromRc: Step 6 DONE — certificate generation complete");

        res.status(200).json({
            "message": "Certificate generated successfully",
            certificateUrl: updateUserCertificateDetailStatus.certificateUrl,
            thumbnailUrl: updateUserCertificateDetailStatus.thumbnailUrl
        })
    } catch (error: any) {
        logger.error({ err: error?.message, userId, templateId, elapsedMs: Date.now() - startTime }, "generateUserCertificatesFromRc: unhandled error");
        return res.status(500).json({ "message": "Failed", "reason": "Something went wrong while generating user certificates" })
    }
}
