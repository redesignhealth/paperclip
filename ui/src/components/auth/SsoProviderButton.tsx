import { Button } from "@/components/ui/button";

/**
 * One configured SSO provider's sign-in button. Shared by the sign-in page and
 * the invite landing page so the invite path offers exactly the same affordance
 * (and the same disabled/loading behavior) as the ordinary login form.
 */
export function SsoProviderButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      className="w-full"
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
