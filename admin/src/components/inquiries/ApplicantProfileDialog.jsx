import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import Grid from '@mui/material/Grid2';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import DescriptionIcon from '@mui/icons-material/DescriptionOutlined';
import DownloadIcon from '@mui/icons-material/DownloadOutlined';

import { formatDate, formatPhone } from '../../utils/format';

function Detail({ label, value }) {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        fontWeight={700}
        textTransform="uppercase"
        letterSpacing={0.4}
      >
        {label}
      </Typography>
      <Typography variant="body2" fontWeight={600} sx={{ mt: 0.4, wordBreak: 'break-word' }}>
        {value || '—'}
      </Typography>
    </Box>
  );
}

/** Full applicant profile, opened from the Careers table's eye icon. */
export default function ApplicantProfileDialog({ application, experienceLabel, resume, onClose }) {
  if (!application) return null;

  const file = application.resume || {};
  const busy = resume?.busyId === application._id;

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, pr: 6, pb: 1 }}>
        Job Applicant Profile
        <IconButton
          onClick={onClose}
          size="small"
          sx={{ position: 'absolute', right: 12, top: 12, color: 'text.secondary' }}
          aria-label="Close"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      {/* No actions row any more, so the content carries the dialog's bottom breathing room. */}
      <DialogContent dividers>
        <Box sx={{ pb: 2 }}>
          <Typography variant="h5" fontWeight={800}>
            {application.name}
          </Typography>
          <Typography variant="body2" color="primary.main" fontWeight={700}>
            {application.position}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Submitted on {formatDate(application.createdAt)}
          </Typography>
        </Box>

        <Divider sx={{ mb: 2.5 }} />

        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Detail label="Email Address" value={application.email} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Detail label="Phone Number" value={formatPhone(application.phone)} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Detail label="Experience Level" value={experienceLabel} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Detail label="Current Location" value={application.location} />
          </Grid>

          <Grid size={12}>
            <Box sx={{ p: 2, borderRadius: 2, bgcolor: 'action.hover' }}>
              <Typography
                variant="caption"
                color="text.secondary"
                fontWeight={700}
                textTransform="uppercase"
                letterSpacing={0.4}
                sx={{ display: 'block', lineHeight: 1.4 }}
              >
                Cover Letter / Message
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.4, whiteSpace: 'pre-wrap' }}>
                {application.coverLetter || 'No message provided.'}
              </Typography>
            </Box>
          </Grid>

          {file.hasFile && (
            <Grid size={12}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                alignItems={{ xs: 'stretch', sm: 'center' }}
                justifyContent="space-between"
                spacing={1.5}
                // Theme tokens rather than a one-off green: the outlined panel picks up
                // the same divider and hover surface every other card in the panel uses.
                sx={{ p: 1.75, borderRadius: 2, border: 1, borderColor: 'divider', bgcolor: 'action.hover' }}
              >
                <Stack direction="row" alignItems="center" spacing={1.25} sx={{ minWidth: 0 }}>
                  <DescriptionIcon sx={{ color: 'primary.main' }} />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={700} noWrap>
                      Resume Attachment
                    </Typography>
                    {file.fileName && (
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {file.fileName}
                      </Typography>
                    )}
                  </Box>
                </Stack>

                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={busy}
                    onClick={() => resume?.view(application)}
                  >
                    View
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={busy}
                    startIcon={<DownloadIcon />}
                    onClick={() => resume?.download(application)}
                  >
                    Download
                  </Button>
                </Stack>
              </Stack>
            </Grid>
          )}
        </Grid>
      </DialogContent>
    </Dialog>
  );
}
