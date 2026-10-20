import { recipeFields, type Recipe } from '../../shared/schema';
import { HelpTip } from './HelpTip';

export function RecipeControls({
  recipe,
  disabled,
  onChange,
}: {
  recipe: Recipe;
  disabled: boolean;
  onChange: (key: keyof Recipe, value: number) => void;
}) {
  return (
    <div className="recipe-sliders">
      {recipeFields.map((field) => (
        <div className="recipe-control" key={field.key}>
          <div className="control-heading">
            <label htmlFor={`recipe-${field.key}`}>{field.label}</label>
            <HelpTip label={field.label}>{field.help}</HelpTip>
            <output htmlFor={`recipe-${field.key}`}>
              {recipe[field.key].toFixed(2)}
              <small>{field.unit}</small>
            </output>
          </div>
          <input
            id={`recipe-${field.key}`}
            type="range"
            min={field.min}
            max={field.max}
            step={field.step}
            value={recipe[field.key]}
            disabled={disabled}
            aria-description={field.help}
            onChange={(event) => onChange(field.key, Number(event.target.value))}
          />
        </div>
      ))}
    </div>
  );
}
