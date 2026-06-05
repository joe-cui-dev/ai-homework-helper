import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthPage } from "./AuthPage";
import type { CognitoUser } from "amazon-cognito-identity-js";

const cognitoUser = {} as CognitoUser;

describe("AuthPage", () => {
  it("moves from sign in to SMS verification when MFA is required", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn().mockResolvedValue({
      type: "sms_mfa_required",
      email: "parent@example.com",
      user: cognitoUser,
      destination: "+61******123",
    });
    const onConfirmMfa = vi.fn().mockResolvedValue(undefined);

    render(
      <AuthPage
        onLogin={onLogin}
        onCompletePassword={vi.fn()}
        onConfirmMfa={onConfirmMfa}
      />,
    );

    await user.type(screen.getByPlaceholderText("you@example.com"), "parent@example.com");
    await user.type(screen.getByPlaceholderText("Your password"), "Secret123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(onLogin).toHaveBeenCalledWith("parent@example.com", "Secret123");
    expect(await screen.findByText(/sent to \+61\*+\*123/)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("123456"), "111222");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(onConfirmMfa).toHaveBeenCalledWith("parent@example.com", cognitoUser, "111222");
  });

  it("shows a friendly error for bad credentials", async () => {
    const user = userEvent.setup();
    const onLogin = vi
      .fn()
      .mockRejectedValue(new Error("NotAuthorizedException"));

    render(
      <AuthPage
        onLogin={onLogin}
        onCompletePassword={vi.fn()}
        onConfirmMfa={vi.fn()}
      />,
    );

    await user.type(screen.getByPlaceholderText("you@example.com"), "parent@example.com");
    await user.type(screen.getByPlaceholderText("Your password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Email or password is incorrect.")).toBeInTheDocument();
  });
});
