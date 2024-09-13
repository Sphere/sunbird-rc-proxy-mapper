import { Request, Response } from "express"
import { logger } from "../utils/logger";
import { client } from "../utils/postgresConnection";
import axios from 'axios';
import sharp from 'sharp';
import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import { Buffer } from 'buffer';

const s3 = new AWS.S3({
    accessKeyId: process.env.ACCESS_KEY_ID,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});
const bucketName = process.env.AWS_BUCKET_NAME || "sunbird-rc-proxy-certificates";
const uploadToS3 = async (fileName: string, fileBuffer: any, bucketName: string) => {
    try {
        const params = {
            Bucket: bucketName,
            Key: fileName,
            Body: fileBuffer,
            ContentType: 'image/png',
        };
        return s3.upload(params).promise();
    } catch (error) {
        logger.error(error)
    }
    
};

export const getUserCertificateDetails = async (req: Request, res: Response) => {
    try {
        const { userId } = req.query
        const selectQuery = 'SELECT * FROM rc_proxy_user_mapping WHERE userId = $1';
        const selectResult = await client.query(selectQuery, [userId]);
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
        res.status(200).json({
            message: "SUCCESS",
            data: formattedResult
        })
    } catch (error) {
        logger.error(error)
        res.status(404).json({
            "message": "User not found",
            "reason": "Something went wrong while retrieving user details"
        })
    }
};
const generateKeycloakAdminToken = async () => {
    try {
        const response = await axios.post(
            `${process.env.SUNBIRD_RC_KEYCLOAK_HOST}/auth/realms/sunbird-rc/protocol/openid-connect/token`,
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
        return response.data.access_token
    } catch (error) {
        logger.info(error)
        return false
    }
};
const generateCertificateFromRC = async (templateId: String, rcCertificateGenerationBody: any, userToken: String) => {
    try {
        const generateCertificateResponseFromRc = await axios.post(
            `${process.env.SUNBIRD_RC_CORE_HOST}/api/v1/${templateId}`,
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
        return generateCertificateResponseFromRc.data.result[`${templateId}`].osid
    } catch (error) {
        logger.info(error)
        return false
    }

}
const getCertificateDetailsFromRC = async (certificateOsid: String, userToken: String, templateId: String) => {
    try {
        const certificateDataFromRc = await axios.get(
            `${process.env.SUNBIRD_RC_CORE_HOST}/api/v1/${templateId}/${certificateOsid}`,
            {
                headers: {
                    'Accept': 'image/svg+xml',
                    'template-key': 'html',
                    'Authorization': `Bearer ${userToken}`
                },
            }
        );
        return certificateDataFromRc.data
    } catch (error) {
        logger.info(error)
        return false
    }
}
const uploadCertificateToS3 = async (certificateDetails: any, templateId: String, userId: String, certificateCreationTime: Number) => {
    try {
        if (typeof certificateDetails === 'string') {
            certificateDetails = certificateDetails.replace(/&nbsp;/g, '&#160;');
            const svgStartIndex = certificateDetails.indexOf('<svg');
            const svgEndIndex = certificateDetails.indexOf('</svg>') + 6;
            if (svgStartIndex !== -1 && svgEndIndex !== -1) {
                certificateDetails = certificateDetails.substring(svgStartIndex, svgEndIndex);
            } else {
                return false
            }
        } else {
            return false
        }
        const certificateBuffer = await sharp(Buffer.from(certificateDetails))
            .png()
            .toBuffer();
        const thumbnailBuffer = await sharp(Buffer.from(certificateDetails))
            .png().
            resize({ width: 200, height: 200 })
            .toBuffer();
        await uploadToS3(`${templateId}/${userId}/${certificateCreationTime}-certificate.png`, certificateBuffer, bucketName);
        await uploadToS3(`${templateId}/${userId}/${certificateCreationTime}-thumbnail.png`, thumbnailBuffer, bucketName);
        return true
    } catch (error) {
        logger.info(error)
        return false
    }

}
const updateUserCertificateDetails = async (userId: String, templateId: String, userName: String, certificateOsid: String, certificateCreationTime: Number,certificateName:String) => {
    try {
        const uuid: string = uuidv4();
        const certificateUrl = `https://${bucketName}.s3.ap-south-1.amazonaws.com/${templateId}/${userId}/${certificateCreationTime}-certificate.png`
        const thumbnailUrl = `https://${bucketName}.s3.ap-south-1.amazonaws.com/${templateId}/${userId}/${certificateCreationTime}-thumbnail.png`
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
        return {
            certificateUrl,
            thumbnailUrl
        }
    } catch (error) {
        logger.info(error)
        return false
    }
}
export const generateUserCertificatesFromRc = async (req: Request, res: Response) => {
    try {
        const { rcCertificateGenerationBody, templateId, userId, userName,certificateName } = req.body
        const certificateCreationTime = Date.now()
        const keycloakAdminToken = await generateKeycloakAdminToken()
        if (!keycloakAdminToken) {
            return res.status(404).json({
                "message": "Failed",
                "reason": "Something went wrong while retrieving admin token"
            })
        }
        const certificateOsid = await generateCertificateFromRC(templateId, rcCertificateGenerationBody, keycloakAdminToken)
        if (!certificateOsid) {
            return res.status(404).json({
                "message": "Failed",
                "reason": "Something went wrong while generating user certificates"
            })
        }
        let certificateDetailsFromRc = await getCertificateDetailsFromRC(certificateOsid, keycloakAdminToken, templateId)
        if (!certificateDetailsFromRc) {
            return res.status(404).json({
                "message": "Failed",
                "reason": "Something went wrong while retrieving user certificates from RC"
            })
        }
        const uploadCertificateStatus = await uploadCertificateToS3(certificateDetailsFromRc, templateId, userId, certificateCreationTime)
        if (!uploadCertificateStatus) {
            return res.status(404).json({
                "message": "Failed",
                "reason": "Something went wrong while uploading user certificates to S3"
            })
        }
        const updateUserCertificateDetailStatus = await updateUserCertificateDetails(userId, templateId, userName, certificateOsid, certificateCreationTime,certificateName)
        if (!updateUserCertificateDetailStatus) {
            return res.status(404).json({
                "message": "Failed",
                "reason": "Something went wrong while updating user certificates details"
            })
        }
        res.status(200).json({
            "message": "Certificate generated successfully",
            certificateUrl: updateUserCertificateDetailStatus.certificateUrl,
            thumbnailUrl: updateUserCertificateDetailStatus.thumbnailUrl
        })
    } catch (error) {
        logger.info(error)
        return res.status(404).json({
            "message": "Failed",
            "reason": "Something went wrong while generating user certificates"
        })
    }
}
