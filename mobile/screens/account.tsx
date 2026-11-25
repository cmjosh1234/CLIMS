import React, { useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, View, type TextInputInstance } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Screen from "@/components/m/Screen";
import Icon from "@/components/m/Icon";
import { Banner, Btn, Btns, Done, Fields, Input, Note, Txt } from "@/components/m/kit";
import { MAX_FORM_WIDTH, useColumn, useResponsive } from "@/hooks/useResponsive";
import { useKeyboardScroll } from "@/hooks/useKeyboardScroll";
import {
  changesSignIn,
  PASSWORD_RULES,
  passwordReady,
  passwordTooLong,
  profileChanges,
  profileFormOf,
  profileProblems,
  type ProfileForm,
} from "@/lib/account";
import { accountErrorMessage, changePassword, fieldErrors, getMe, updateProfile } from "@/lib/api";
import { TYPE } from "@/lib/fonts";
import { useNav } from "@/lib/nav";
import { useMe, useSession } from "@/lib/session";
import { useT } from "@/lib/theme";

/* The signed-in person's own account: the new password a first sign-in asks for, and the Me tab's
 * Edit details and Change password screens. Nothing here works offline: the API must accept it. */

/** The password rules, ticked off as the person types. */
export function PasswordRules({
  password,
  confirmation,
}: {
  password: string;
  confirmation: string;
}) {
  const T = useT();
  return (
    <View
      accessibilityLabel="Password rules"
      style={{ marginHorizontal: 16, marginBottom: T.secGap, gap: 8, paddingHorizontal: 4 }}
    >
      {PASSWORD_RULES.map((rule) => {
        const met = rule.isMet(password, confirmation);
        const color = met ? T.tones.success.fg : T.fg2;
        return (
          <View
            key={rule.id}
            accessible
            // The state in words, so it is not carried by the icon and colour alone.
            accessibilityLabel={`${met ? "Done" : "Not yet"}: ${rule.label}`}
            style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
          >
            <View style={{ width: 18, alignItems: "center" }}>
              {met ? (
                <Icon name="check" size={18} color={color} />
              ) : (
                <View
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    borderWidth: 1.5,
                    borderColor: T.fg3,
                  }}
                />
              )}
            </View>
            <Txt style={{ ...TYPE.subhead, color }}>{rule.label}</Txt>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Shown in place of the tabs while the account still has a password someone else chose: the DCFP
 * or an administrator created it, or gave it a temporary one. The API refuses everything else until
 * it is replaced, so nothing behind this screen loads until then.
 */
export function ChooseNewPassword() {
  const T = useT();
  const insets = useSafeAreaInsets();
  const col = useColumn(MAX_FORM_WIDTH);
  const { isShort } = useResponsive();
  const { user, replaceUser, signOut } = useSession();
  const setScroll = useKeyboardScroll();
  const confirmInput = useRef<TextInputInstance>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState("");
  const [busy, setBusy] = useState(false);
  const tooLong = passwordTooLong(password);
  const ready = passwordReady(password, confirmation) && !busy;

  const save = async () => {
    if (!ready) return;
    setRefused("");
    setErrs({});
    setBusy(true);
    try {
      const changed = await changePassword({ new_password: password });
      // The tabs replace this screen once the saved account no longer needs a new password.
      await replaceUser(changed.user);
    } catch (e) {
      const fields = fieldErrors(e);
      if (fields.current_password) {
        // The server wants the current password, so it no longer needs a change: this phone's copy
        // of the account is out of date (changed on another device). Take the server's.
        try {
          const fresh = await getMe();
          if (!fresh.must_change_password) return await replaceUser(fresh);
        } catch {
          // Fall through to the message below.
        }
      }
      if (fields.new_password) setErrs({ new_password: fields.new_password });
      else setRefused(accountErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: T.bg }} behavior="padding">
      <ScrollView
        ref={setScroll}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          col.style,
          {
            flexGrow: 1,
            justifyContent: "center",
            paddingTop: insets.top + (isShort ? 12 : 32),
            paddingBottom: insets.bottom + 16,
          },
        ]}
      >
        <View style={{ paddingHorizontal: 16, marginBottom: isShort ? 12 : 20, gap: 8 }}>
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: 26,
              backgroundColor: T.tones.info.bg,
              alignItems: "center",
              justifyContent: "center",
              marginBottom: 4,
            }}
          >
            <Icon name="shield" size={26} color={T.tones.info.fg} />
          </View>
          <Txt accessibilityRole="header" style={{ ...TYPE.title, fontWeight: "700" }}>
            Choose a new password
          </Txt>
          <Txt style={{ ...TYPE.subhead, color: T.fg2 }}>
            Your account was set up with a temporary password. Choose your own to keep using CLIMS,
            and don&apos;t share it with anyone.
          </Txt>
          {user ? (
            <Txt style={{ ...TYPE.footnote, color: T.fg2 }}>
              Signed in as{" "}
              <Txt style={{ ...TYPE.footnote, color: T.fg, fontWeight: "600" }}>{user.name}</Txt>
              {user.name !== user.username ? ` · ${user.username}` : ""}
            </Txt>
          ) : null}
        </View>

        {refused ? (
          <Banner tone="danger" title="Couldn't save your password" body={refused} />
        ) : null}
        <View style={{ marginHorizontal: 16, marginBottom: 16, gap: 14 }}>
          <Input
            label="New password"
            outlined
            leadingIcon="shield"
            value={password}
            onChangeText={(value) => {
              setPassword(value);
              setErrs({});
              setRefused("");
            }}
            secure
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="password-new"
            err={errs.new_password || tooLong}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => confirmInput.current?.focus()}
          />
          <Input
            label="Type it again"
            outlined
            leadingIcon="shield"
            value={confirmation}
            onChangeText={(value) => {
              setConfirmation(value);
              setRefused("");
            }}
            secure
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="password-new"
            inputRef={confirmInput}
            returnKeyType="done"
            onSubmitEditing={save}
          />
        </View>
        <PasswordRules password={password} confirmation={confirmation} />
        <Btns>
          <Btn label={busy ? "Saving…" : "Save password"} onPress={save} dis={!ready} />
          <Btn
            label="Sign out"
            kind="text"
            onPress={async () => {
              await signOut();
              router.replace("/signin");
            }}
          />
        </Btns>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Me › Edit details: the person's own name, email address and phone number. */
export function EditDetails() {
  const me = useMe();
  const nav = useNav();
  const { replaceUser } = useSession();
  const [before] = useState(() => profileFormOf(me));
  const [form, setForm] = useState(before);
  const [current, setCurrent] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<null | { signIn: boolean }>(null);
  const changes = profileChanges(before, form);
  const needsPassword = changesSignIn(changes);
  const changed = Object.keys(changes).length > 0;

  const edit = (key: keyof ProfileForm, field: string) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrs((e) => ({ ...e, [field]: "" }));
    setRefused("");
  };

  const save = async () => {
    if (!changed || busy) return;
    const problems = profileProblems(changes);
    if (needsPassword && !current)
      problems.current_password = "Enter your current password to change how you sign in.";
    if (Object.keys(problems).length) {
      setErrs(problems);
      return;
    }
    setRefused("");
    setBusy(true);
    try {
      const user = await updateProfile(
        needsPassword ? { ...changes, current_password: current } : changes,
      );
      await replaceUser(user);
      setSaved({ signIn: needsPassword });
    } catch (e) {
      const fields = fieldErrors(e);
      if (Object.keys(fields).length) setErrs(fields);
      else setRefused(accountErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (saved)
    return (
      <Screen title="Edit details" backLabel="Me">
        <Done
          title="Details saved"
          body={
            saved.signIn
              ? "From now on, sign in with your new email address or phone number, or your username."
              : "Your name is updated in CLIMS."
          }
        />
        <Btns>
          <Btn label="Done" onPress={nav.back} />
        </Btns>
      </Screen>
    );

  return (
    <Screen title="Edit details" backLabel="Me">
      {refused ? <Banner tone="danger" title="Couldn't save" body={refused} /> : null}
      <Fields h="Name">
        <Input
          label="First name"
          value={form.firstName}
          onChangeText={edit("firstName", "first_name")}
          autoCapitalize="words"
          autoComplete="given-name"
          max={20}
          err={errs.first_name}
        />
        <Input
          label="Last name"
          value={form.lastName}
          onChangeText={edit("lastName", "last_name")}
          autoCapitalize="words"
          autoComplete="family-name"
          max={20}
          err={errs.last_name}
        />
      </Fields>
      <Fields h="Contact" f="You can sign in with your email address, phone number or username.">
        <Input
          label="Email"
          value={form.email}
          onChangeText={edit("email", "email")}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          ph="name@example.org"
          err={errs.email}
        />
        <Input
          label="Phone"
          value={form.phone}
          onChangeText={edit("phone", "phone_number")}
          keyboardType="phone-pad"
          autoComplete="tel"
          ph="0772 123456"
          err={errs.phone_number}
        />
      </Fields>
      {needsPassword ? (
        <Fields h="Confirm it's you" f="Changing how you sign in needs your current password.">
          <Input
            label="Current password"
            value={current}
            onChangeText={(value) => {
              setCurrent(value);
              setErrs((e) => ({ ...e, current_password: "" }));
              setRefused("");
            }}
            secure
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            err={errs.current_password}
          />
        </Fields>
      ) : null}
      <Btns>
        <Btn label={busy ? "Saving…" : "Save changes"} onPress={save} dis={!changed || busy} />
      </Btns>
      <Note text="Your username, role and work assignments are managed by your district focal person." />
    </Screen>
  );
}

/** Me › Change password. This phone stays signed in; every other device is signed out. */
export function ChangePassword() {
  const nav = useNav();
  const { replaceUser } = useSession();
  const newInput = useRef<TextInputInstance>(null);
  const confirmInput = useRef<TextInputInstance>(null);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState("");
  const [busy, setBusy] = useState(false);
  const [signedOut, setSignedOut] = useState<number | null>(null);
  const tooLong = passwordTooLong(password);
  const ready = !!current && passwordReady(password, confirmation) && !busy;

  const save = async () => {
    if (!ready) return;
    setRefused("");
    setErrs({});
    setBusy(true);
    try {
      const changed = await changePassword({ current_password: current, new_password: password });
      await replaceUser(changed.user);
      setSignedOut(changed.sessions_revoked);
    } catch (e) {
      const fields = fieldErrors(e);
      if (fields.current_password || fields.new_password) setErrs(fields);
      else setRefused(accountErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (signedOut !== null)
    return (
      <Screen title="Change password" backLabel="Me">
        <Done
          title="Password changed"
          body={
            signedOut > 0
              ? `You're still signed in on this phone. ${
                  signedOut === 1 ? "1 other device was" : `${signedOut} other devices were`
                } signed out.`
              : "Use your new password the next time you sign in."
          }
        />
        <Btns>
          <Btn label="Done" onPress={nav.back} />
        </Btns>
      </Screen>
    );

  return (
    <Screen title="Change password" backLabel="Me">
      {refused ? (
        <Banner tone="danger" title="Couldn't change your password" body={refused} />
      ) : null}
      <Fields h="Current password">
        <Input
          label="Current password"
          value={current}
          onChangeText={(value) => {
            setCurrent(value);
            setErrs((e) => ({ ...e, current_password: "" }));
            setRefused("");
          }}
          secure
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          err={errs.current_password}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => newInput.current?.focus()}
        />
      </Fields>
      <Fields h="New password">
        <Input
          label="New password"
          value={password}
          onChangeText={(value) => {
            setPassword(value);
            setErrs((e) => ({ ...e, new_password: "" }));
            setRefused("");
          }}
          secure
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="password-new"
          inputRef={newInput}
          err={errs.new_password || tooLong}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => confirmInput.current?.focus()}
        />
        <Input
          label="Type it again"
          value={confirmation}
          onChangeText={(value) => {
            setConfirmation(value);
            setRefused("");
          }}
          secure
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="password-new"
          inputRef={confirmInput}
          returnKeyType="done"
          onSubmitEditing={save}
        />
      </Fields>
      <PasswordRules password={password} confirmation={confirmation} />
      <Btns>
        <Btn label={busy ? "Saving…" : "Change password"} onPress={save} dis={!ready} />
      </Btns>
      <Note text="You stay signed in on this phone. CLIMS signs you out on every other device." />
    </Screen>
  );
}
