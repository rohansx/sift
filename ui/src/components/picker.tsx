import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * One labelled dropdown over a list of strings — agent, facet, window, from, to.
 *
 * Everything selectable in this dashboard is "pick one of these strings the
 * server told us about", which is why there is one of these and not five.
 */
export function Picker({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string | undefined;
  options: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <Select value={value ?? ""} onValueChange={onChange} disabled={disabled || options.length === 0}>
        <SelectTrigger size="sm" className="font-mono tabular-nums">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option} className="font-mono tabular-nums">
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
