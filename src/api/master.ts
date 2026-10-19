import { Router, Request, Response } from 'express'
import { body, validationResult } from 'express-validator'
import { JobRepository } from '../persistence/JobRepository'

const router = Router()
const repo = new JobRepository()

function validate(req: Request, res: Response): boolean {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() })
    return false
  }
  return true
}

router.get('/schema', async (_req: Request, res: Response) => {
  const schema = await repo.getMasterSchema()
  res.json(schema)
})

router.post(
  '/seed-skills',
  body('skills').isArray({ min: 1 }),
  body('skills.*.name').isString().notEmpty(),
  body('skills.*.slug').isString().notEmpty(),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const skills: Array<{ name: string; slug: string }> = req.body.skills
    const now = new Date()
    for (const skill of skills) {
      await repo.upsertSkill({ id: crypto.randomUUID(), name: skill.name, slug: skill.slug })
    }
    res.json({ seeded: skills.length })
  }
)

router.post(
  '/seed-categories',
  body('categories').isArray({ min: 1 }),
  body('categories.*.name').isString().notEmpty(),
  body('categories.*.slug').isString().notEmpty(),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const categories: Array<{ name: string; slug: string; description?: string }> = req.body.categories
    for (const cat of categories) {
      await repo.upsertCategory({ id: crypto.randomUUID(), name: cat.name, slug: cat.slug, description: cat.description ?? null })
    }
    res.json({ seeded: categories.length })
  }
)

router.post(
  '/seed-cities',
  body('cities').isArray({ min: 1 }),
  body('cities.*.name').isString().notEmpty(),
  body('cities.*.country_id').isUUID(),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const cities: Array<{ name: string; country_id: string }> = req.body.cities
    for (const city of cities) {
      await repo.upsertCity({ id: crypto.randomUUID(), country_id: city.country_id, name: city.name })
    }
    res.json({ seeded: cities.length })
  }
)

router.post(
  '/seed-countries',
  body('countries').isArray({ min: 1 }),
  body('countries.*.name').isString().notEmpty(),
  body('countries.*.code').optional().isString(),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const countries: Array<{ name: string; code?: string }> = req.body.countries
    for (const country of countries) {
      await repo.upsertCountry({ id: crypto.randomUUID(), name: country.name, code: country.code ?? null })
    }
    res.json({ seeded: countries.length })
  }
)

export default router
