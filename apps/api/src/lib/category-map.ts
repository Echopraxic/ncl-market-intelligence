export type NclCategory =
  | 'toys_games'
  | 'food_beverage'
  | 'supplements'
  | 'cosmetics_personal_care'
  | 'home_goods';

export const NCL_CATEGORIES: NclCategory[] = [
  'toys_games',
  'food_beverage',
  'supplements',
  'cosmetics_personal_care',
  'home_goods',
];

const CATEGORY_MAP: Record<string, NclCategory> = {
  // Human-readable → slug
  'toys & games':                'toys_games',
  'toy & games':                 'toys_games',
  'toys':                        'toys_games',
  'games':                       'toys_games',
  'consumer packaged goods':     'food_beverage',
  'cpg':                         'food_beverage',
  'food & drink':                'food_beverage',
  'food and drink':              'food_beverage',
  'food':                        'food_beverage',
  'grocery':                     'food_beverage',
  'snacks':                      'food_beverage',
  'wellness & supplements':      'supplements',
  'supplements':                 'supplements',
  'health & wellness':           'supplements',
  'health and wellness':         'supplements',
  'vitamins':                    'supplements',
  'health & personal care':      'supplements',
  'health and personal care':    'supplements',
  'cosmetics_personal_care':     'cosmetics_personal_care',
  'health & beauty':             'cosmetics_personal_care',
  'health and beauty':           'cosmetics_personal_care',
  'beauty':                      'cosmetics_personal_care',
  'skincare':                    'cosmetics_personal_care',
  'personal care':               'cosmetics_personal_care',
  'home goods':                  'home_goods',
  'home & kitchen':              'home_goods',
  'home and kitchen':            'home_goods',
  'home & garden':               'home_goods',
  'home':                        'home_goods',
  'kitchen':                     'home_goods',
  // Slugs map to themselves (idempotent)
  'toys_games':                  'toys_games',
  'food_beverage':               'food_beverage',
  'home_goods':                  'home_goods',
};

export function toNclCategory(raw: string): NclCategory | null {
  return CATEGORY_MAP[raw.toLowerCase().trim()] ?? null;
}

export function isNclCategory(raw: string): raw is NclCategory {
  return NCL_CATEGORIES.includes(raw as NclCategory);
}
