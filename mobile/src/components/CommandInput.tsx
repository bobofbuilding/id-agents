import React, { useState, useRef } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  Keyboard,
} from 'react-native';
import { colors, fonts, spacing } from '../theme';

interface Props {
  onSubmit: (command: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function CommandInput({
  onSubmit,
  disabled = false,
  placeholder = '/agents, /status, /ask agent msg...',
}: Props) {
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setText('');
    // Keep keyboard open for rapid commands
  };

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <View style={styles.container}>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={text}
        onChangeText={setText}
        onSubmitEditing={handleSubmit}
        placeholder={placeholder}
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        returnKeyType="send"
        editable={!disabled}
        blurOnSubmit={false}
        accessibilityRole="text"
        accessibilityLabel="Command"
        accessibilityHint="Enter a command to send to the connected agent terminal."
        accessibilityState={{ disabled }}
      />
      <TouchableOpacity
        style={[styles.button, !canSend && styles.buttonDisabled]}
        onPress={handleSubmit}
        disabled={!canSend}
        accessibilityRole="button"
        accessibilityLabel="Send command"
        accessibilityHint="Submits the command in the terminal."
        accessibilityState={{ disabled: !canSend }}
      >
        <Text style={styles.buttonText}>Send</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: fonts.size.base,
    color: colors.text,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  button: {
    backgroundColor: colors.blue,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 6,
    minHeight: 44,
    minWidth: 64,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    fontFamily: fonts.mono,
    fontSize: fonts.size.sm,
    color: colors.bg,
    fontWeight: '700',
  },
});
