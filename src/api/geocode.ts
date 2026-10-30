import { Router, Request, Response } from 'express'
import { body, validationResult } from 'express-validator'
import { geocodeAddress, GeocodingError } from '../services/geocoding'

const router = Router()
router.post('/', [body('address').isString().trim().notEmpty()], async (req: Request, res: Response) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Address is required' })
    return
  }
  try {
    res.json(await geocodeAddress(req.body.address.trim()))
  } catch (error) {
    if (error instanceof GeocodingError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    res.status(502).json({ error: 'Geocoding provider request failed' })
  }
})
export default router
