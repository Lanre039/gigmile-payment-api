import { Router } from 'express';
import { receivePaymentSync, receivePaymentAsync } from '../controllers/paymentController';

const router = Router();

router.post('/payments', receivePaymentSync);
router.post('/payments/webhook', receivePaymentAsync);

export default router;
