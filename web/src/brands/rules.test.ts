import { describe, expect, it } from 'vitest';
import { brandForLocation, brandsForLocations, suggestBrand } from './rules';

describe('brand rules', () => {
  it('knows UrbanMop locations by name', () => {
    expect(suggestBrand('Ottawa')).toBe('residential');
    expect(suggestBrand('Kitchener-Waterloo')).toBe('residential');
    expect(suggestBrand('Carpet Cleaning')).toBe('residential');
    expect(suggestBrand('Commercial Ottawa')).toBe('commercial');
    expect(suggestBrand('Cornwall')).toBe('commercial');
    expect(suggestBrand('Kingston')).toBeNull();
  });
  it('admin choices win, including "no brand"', () => {
    expect(brandForLocation(5, 'Kingston', { 5: 'commercial' })).toBe('commercial');
    expect(brandForLocation(1, 'Ottawa', { 1: null })).toBeNull();
    expect(brandForLocation(1, 'Ottawa', {})).toBe('residential');
  });
  it('a cleaner in both brands is shared', () => {
    const of = (id: number) => (id === 1 ? 'residential' : id === 2 ? 'commercial' : null);
    expect(brandsForLocations([1, 2, 3], of)).toEqual(['commercial', 'residential']);
    expect(brandsForLocations([1, 1], of)).toEqual(['residential']);
  });
});
