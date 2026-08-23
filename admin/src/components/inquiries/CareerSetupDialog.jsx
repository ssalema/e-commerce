import { useState } from 'react';
import { useSnackbar } from 'notistack';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import Grid from '@mui/material/Grid2';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import CloseIcon from '@mui/icons-material/Close';
import SaveIcon from '@mui/icons-material/SaveOutlined';

import { careerApi } from '../../api/endpoints';
import StatusChip from '../common/StatusChip';
import PhoneField from '../common/PhoneField';
import { phoneDigits } from '../../utils/format';

const EMPLOYMENT_TYPES = [
  { value: 'full-time', label: 'Full time' },
  { value: 'part-time', label: 'Part time' },
  { value: 'internship', label: 'Internship' },
  { value: 'contract', label: 'Contract' },
];

const EMPTY_POSITION = { title: '', department: '', location: '', type: 'full-time' };

/**
 * The careers page's admin-owned pieces, in one dialog: the open-roles list that
 * fills its "Position Applying For" dropdown, the experience options beside it, and
 * the "Contact HR" card. Nothing about the careers page is hardcoded in the storefront.
 */
export default function CareerSetupDialog({ positions, experienceLevels, hr, onClose, onChanged }) {
  const { enqueueSnackbar } = useSnackbar();

  const [draft, setDraft] = useState(EMPTY_POSITION);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  const [levelDraft, setLevelDraft] = useState('');
  const [addingLevel, setAddingLevel] = useState(false);
  const [levelError, setLevelError] = useState('');

  // The number is stored as the ten digits every other phone on the platform is;
  // the +91 the field shows is presentation, so anything older saved with the code
  // in the string is reduced on the way in.
  const savedContact = { hrEmail: hr?.email || '', hrPhone: phoneDigits(hr?.phone) };
  const [contact, setContact] = useState(savedContact);
  const [savingContact, setSavingContact] = useState(false);

  const contactChanged =
    contact.hrEmail.trim() !== savedContact.hrEmail.trim() ||
    contact.hrPhone !== savedContact.hrPhone;

  const addPosition = async () => {
    if (draft.title.trim().length < 2) return setError('Enter a position title');

    setAdding(true);
    try {
      await careerApi.createPosition({
        title: draft.title.trim(),
        department: draft.department.trim(),
        location: draft.location.trim(),
        type: draft.type,
        // New roles land at the end of the storefront dropdown.
        displayOrder: positions.length,
      });
      enqueueSnackbar('Position added', { variant: 'success' });
      setDraft(EMPTY_POSITION);
      onChanged();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not add the position', { variant: 'error' });
    } finally {
      setAdding(false);
    }
  };

  const togglePosition = async (position) => {
    try {
      await careerApi.updatePosition(position._id, { isActive: !position.isActive });
      onChanged();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not update the position', { variant: 'error' });
    }
  };

  const removePosition = async (position) => {
    try {
      await careerApi.removePosition(position._id);
      enqueueSnackbar('Position removed', { variant: 'success' });
      onChanged();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not remove the position', { variant: 'error' });
    }
  };

  const addLevel = async () => {
    if (levelDraft.trim().length < 2) return setLevelError('Enter an experience label');

    setAddingLevel(true);
    try {
      await careerApi.createExperienceLevel({
        label: levelDraft.trim(),
        // New options land at the end of the storefront dropdown.
        displayOrder: experienceLevels.length,
      });
      enqueueSnackbar('Experience level added', { variant: 'success' });
      setLevelDraft('');
      onChanged();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not add the experience level', { variant: 'error' });
    } finally {
      setAddingLevel(false);
    }
  };

  const toggleLevel = async (level) => {
    try {
      await careerApi.updateExperienceLevel(level._id, { isActive: !level.isActive });
      onChanged();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not update the experience level', { variant: 'error' });
    }
  };

  const removeLevel = async (level) => {
    try {
      await careerApi.removeExperienceLevel(level._id);
      enqueueSnackbar('Experience level removed', { variant: 'success' });
      onChanged();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not remove the experience level', { variant: 'error' });
    }
  };

  const saveContact = async () => {
    setSavingContact(true);
    try {
      await careerApi.updateConfig(contact);
      enqueueSnackbar('HR contact details saved', { variant: 'success' });
      onChanged();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not save the HR contact details', { variant: 'error' });
    } finally {
      setSavingContact(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, pr: 6 }}>
        Careers page setup
        <IconButton
          onClick={onClose}
          size="small"
          sx={{ position: 'absolute', right: 12, top: 12, color: 'text.secondary' }}
          aria-label="Close without saving"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        <Typography variant="h6" sx={{ mb: 2 }}>
          Contact HR
        </Typography>

        <Grid container spacing={2} alignItems="flex-start">
          <Grid size={{ xs: 12, sm: 5 }}>
            <TextField
              fullWidth
              size="small"
              label="HR email"
              placeholder="hr@example.com"
              value={contact.hrEmail}
              onChange={(e) => setContact((c) => ({ ...c, hrEmail: e.target.value }))}
              inputProps={{ maxLength: 120 }}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 5 }}>
            <PhoneField
              fullWidth
              size="small"
              label="HR phone"
              placeholder="9876543210"
              value={contact.hrPhone}
              onChange={(e) => setContact((c) => ({ ...c, hrPhone: e.target.value }))}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 2 }}>
            {/* Nothing to send until something is actually different, so the button
                doubles as the cue that there are unsaved edits. */}
            <Button
              fullWidth
              variant="outlined"
              onClick={saveContact}
              disabled={savingContact || !contactChanged}
              startIcon={savingContact ? <CircularProgress size={15} color="inherit" /> : <SaveIcon />}
            >
              Update
            </Button>
          </Grid>
        </Grid>

        <Divider sx={{ my: 3 }} />

        <Typography variant="h6" sx={{ mb: 2 }}>
          Open positions
        </Typography>

        <Grid container spacing={1.5} alignItems="flex-start" sx={{ mb: 2 }}>
          <Grid size={{ xs: 12, sm: 4 }}>
            <TextField
              fullWidth
              size="small"
              label="Position title"
              placeholder="e.g. Spring Designer"
              value={draft.title}
              onChange={(e) => {
                setDraft((d) => ({ ...d, title: e.target.value }));
                if (error) setError('');
              }}
              error={Boolean(error)}
              helperText={error}
              inputProps={{ maxLength: 80 }}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 3 }}>
            <TextField
              fullWidth
              size="small"
              label="Department"
              value={draft.department}
              onChange={(e) => setDraft((d) => ({ ...d, department: e.target.value }))}
              inputProps={{ maxLength: 60 }}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 3 }}>
            <TextField
              fullWidth
              size="small"
              select
              label="Type"
              value={draft.type}
              onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}
            >
              {EMPLOYMENT_TYPES.map((type) => (
                <MenuItem key={type.value} value={type.value}>
                  {type.label}
                </MenuItem>
              ))}
            </TextField>
          </Grid>
          <Grid size={{ xs: 12, sm: 2 }}>
            <Button
              fullWidth
              variant="contained"
              onClick={addPosition}
              disabled={adding}
              startIcon={adding ? <CircularProgress size={15} color="inherit" /> : <AddIcon />}
            >
              Add
            </Button>
          </Grid>
        </Grid>

        <Stack spacing={1}>
          {positions.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No positions yet — the careers form stays disabled until at least one role is open.
            </Typography>
          )}

          {positions.map((position) => (
            <Stack
              key={position._id}
              direction="row"
              alignItems="center"
              spacing={1.5}
              sx={{ p: 1.25, borderRadius: 2, border: 1, borderColor: 'divider' }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" fontWeight={700} noWrap>
                  {position.title}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {[position.department, position.location, position.type].filter(Boolean).join(' · ')}
                </Typography>
              </Box>

              {/* The chip is the control, the way an account's status is on Users —
                  one thing to read and click rather than a label beside a switch. */}
              <Tooltip title={position.isActive ? 'Close this role' : 'Reopen this role'}>
                <Box
                  component="span"
                  onClick={() => togglePosition(position)}
                  sx={{ cursor: 'pointer', display: 'inline-block' }}
                >
                  <StatusChip status={position.isActive ? 'open' : 'closed'} kind="position" />
                </Box>
              </Tooltip>
              <Tooltip title="Remove permanently">
                <IconButton size="small" color="error" onClick={() => removePosition(position)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Stack>

        <Divider sx={{ my: 3 }} />

        <Typography variant="h6" sx={{ mb: 2 }}>
          Experience levels
        </Typography>

        <Grid container spacing={1.5} alignItems="flex-start" sx={{ mb: 2 }}>
          <Grid size={{ xs: 12, sm: 10 }}>
            <TextField
              fullWidth
              size="small"
              label="Experience label"
              placeholder="e.g. 5-8 Years"
              value={levelDraft}
              onChange={(e) => {
                setLevelDraft(e.target.value);
                if (levelError) setLevelError('');
              }}
              error={Boolean(levelError)}
              helperText={levelError}
              inputProps={{ maxLength: 40 }}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 2 }}>
            <Button
              fullWidth
              variant="contained"
              onClick={addLevel}
              disabled={addingLevel}
              startIcon={addingLevel ? <CircularProgress size={15} color="inherit" /> : <AddIcon />}
            >
              Add
            </Button>
          </Grid>
        </Grid>

        <Stack spacing={1}>
          {experienceLevels.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No experience levels yet — the careers form cannot be submitted until at least one
              is on offer.
            </Typography>
          )}

          {experienceLevels.map((level) => (
            <Stack
              key={level._id}
              direction="row"
              alignItems="center"
              spacing={1.5}
              sx={{ p: 1.25, borderRadius: 2, border: 1, borderColor: 'divider' }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" fontWeight={700} noWrap>
                  {level.label}
                </Typography>
              </Box>

              <Tooltip title={level.isActive ? 'Stop offering this option' : 'Offer this option again'}>
                <Box
                  component="span"
                  onClick={() => toggleLevel(level)}
                  sx={{ cursor: 'pointer', display: 'inline-block' }}
                >
                  <StatusChip status={level.isActive ? 'offered' : 'hidden'} kind="experience" />
                </Box>
              </Tooltip>
              <Tooltip title="Remove permanently">
                <IconButton size="small" color="error" onClick={() => removeLevel(level)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
